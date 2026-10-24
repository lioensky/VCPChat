import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const idle = require('../modules/deskpet/idleChat.js');
const prefs = require('../modules/deskpet/petPrefs.js');

// 本地时间下午三点：不在深夜
const AFTERNOON = new Date(2026, 9, 9, 15, 0, 0).getTime();
const MIN = 60 * 1000;

function base(extra = {}) {
    return { enabled: true, minutes: 30, now: AFTERNOON, lastActivityAt: AFTERNOON - 31 * MIN, ...extra };
}

test('idle chat speaks only when on, quiet long enough, user present and not at night', () => {
    assert.equal(idle.shouldSpeak(base()).ok, true);
    assert.equal(idle.shouldSpeak(base({ enabled: false })).reason, 'off');
    assert.equal(idle.shouldSpeak(base({ doNotDisturb: true })).reason, 'dnd');
    assert.equal(idle.shouldSpeak(base({ visible: false })).reason, 'hidden');
    assert.equal(idle.shouldSpeak(base({ systemIdleSec: idle.AWAY_AFTER_SEC })).reason, 'away', '人离开电脑了');
    assert.equal(idle.shouldSpeak(base({ locked: true })).reason, 'away');
    assert.equal(idle.shouldSpeak(base({ lastActivityAt: AFTERNOON - 10 * MIN })).reason, 'recent');
    assert.equal(idle.shouldSpeak(base({ minutes: 10, lastActivityAt: AFTERNOON - 11 * MIN })).ok, true);
    assert.equal(idle.shouldSpeak(base({ lastAttemptAt: AFTERNOON - 5 * MIN })).reason, 'recent', '刚试过一次不连着说');
    assert.equal(idle.shouldSpeak(base({ lastFailedAt: AFTERNOON - 2 * MIN })).reason, 'retry-later');
    const night = new Date(2026, 9, 9, 23, 30, 0).getTime();
    assert.equal(idle.shouldSpeak(base({ now: night, lastActivityAt: night - 60 * MIN })).reason, 'night');
    const early = new Date(2026, 9, 9, 7, 59, 0).getTime();
    assert.equal(idle.shouldSpeak(base({ now: early, lastActivityAt: early - 60 * MIN })).reason, 'night');
});

test('interval falls back to 30 minutes for odd values', () => {
    assert.equal(idle.normalizeMinutes(10), 10);
    assert.equal(idle.normalizeMinutes(7), 30);
    assert.equal(prefs.normalizeSettings({ idleChat: true, idleChatMinutes: 60 }).idleChatMinutes, 60);
    assert.equal(prefs.normalizeSettings({ idleChatMinutes: 5 }).idleChatMinutes, 30);
    assert.equal(prefs.normalizeSettings({ idleChat: 'yes' }).idleChat, false);
    assert.deepEqual([...prefs.IDLE_CHAT_MINUTES], [...idle.IDLE_CHAT_MINUTES]);
});

test('request carries the persona, recent turns without thinking or tags, and the nudge last', () => {
    const history = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: '<think>secret</think><!--emo:happy 0.8-->a1' },
        { role: 'assistant', content: 'thinking…', isThinking: true },
        { role: 'system', content: 'ignored' },
        { role: 'user', content: { text: 'u2' } },
    ];
    const messages = idle.buildMessages({ config: { systemPrompt: '你是{{AgentName}}' }, agentName: 'Nova', history, promptAppend: '【情绪】', userName: 'Roxy', now: AFTERNOON });
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '你是Nova\n\n【情绪】');
    assert.deepEqual(messages.slice(1, -1), [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }]);
    const last = messages.at(-1);
    assert.equal(last.role, 'user');
    assert.match(last.content, /15:00/);
    assert.match(last.content, /Roxy/);
    // 预设模式用预设提示词
    assert.equal(idle.buildMessages({ config: { promptMode: 'preset', presetSystemPrompt: 'P' }, agentName: 'N' })[0].content, 'P');
});

test('reply is cleaned into one speakable line with its emotion', () => {
    const line = idle.cleanLine('<think>hm</think><!--emo:curious 0.6-->「在忙什么呀？」');
    assert.equal(line.text, '在忙什么呀？');
    assert.equal(line.emotion, 'curious');
    assert.equal(line.intensity, 0.6);
    assert.equal(idle.cleanLine('<!--emo:happy/nod 0.9-->嗨').emotion, 'happy');
    assert.equal(idle.cleanLine('  '), null);
    assert.equal(idle.cleanLine('<<<[TOOL_REQUEST]>>>x<<<[END_TOOL_REQUEST]>>>'), null);
    const long = idle.cleanLine(`${'很长的一句话'.repeat(10)}。${'后面还有'.repeat(30)}`);
    assert.ok(long.text.length <= 161);
    assert.ok(long.text.endsWith('。'));
});

test('generate posts a non-streaming request and reads the first choice', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
        sent = { url, init: { ...init, body: JSON.parse(init.body) } };
        return { ok: true, json: async () => ({ choices: [{ message: { content: '嗨' } }] }) };
    };
    const text = await idle.generate({ fetchImpl, url: 'http://x/v1/chat/completions', key: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(text, '嗨');
    assert.equal(sent.init.body.stream, false);
    assert.equal(sent.init.body.model, 'm');
    assert.equal(sent.init.headers.Authorization, 'Bearer k');
    await assert.rejects(idle.generate({ fetchImpl: async () => ({ ok: false, status: 500 }), url: 'u', model: 'm', messages: [] }), /500/);
    await assert.rejects(idle.generate({ fetchImpl, url: '', model: 'm', messages: [] }));
});

test('lines go into one dedicated topic without switching the current topic', async () => {
    let config = { name: 'Nova', current_topic_id: 'topic_main', topics: [{ id: 'topic_main', name: '主话题' }] };
    const histories = new Map();
    const updateConfig = async (_id, updater) => {
        const next = updater(structuredClone(config));
        config = next.config;
        return next;
    };
    const historyQueue = { mutate: async ({ topicId }, fn) => { histories.set(topicId, await fn(histories.get(topicId) || [])); } };
    const agent = { id: 'a1', name: 'Nova' };
    const first = await idle.recordLine({ agent, text: '<!--emo:happy 0.6-->嗨', updateConfig, historyQueue, now: AFTERNOON });
    const second = await idle.recordLine({ agent, text: '还在吗', updateConfig, historyQueue, now: AFTERNOON + MIN });
    assert.equal(first, second, '同一个话题');
    assert.equal(config.current_topic_id, 'topic_main', '不切走用户当前的话题');
    assert.equal(config.topics.length, 2);
    assert.equal(config.topics[0].name, idle.IDLE_TOPIC_NAME);
    assert.equal(config.topics[0].unread, true);
    const saved = histories.get(first);
    assert.deepEqual(saved.map((m) => m.content), ['<!--emo:happy 0.6-->嗨', '还在吗']);
    assert.equal(saved[0].role, 'assistant');
    assert.equal(saved[0].agentId, 'a1');
});
