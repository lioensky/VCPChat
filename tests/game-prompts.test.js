'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatInvite, formatPublicEvent } = require('../Groupmodules/modes/gamePrompts');
test('邀请仅包含Markdown当前状态，不重复公开历史和工具说明', () => {
    const observation = {
        matchId: 'match-test', seat: 2, landlord: 1,
        phase: 'playing', canPass: true, hand: ['C4'],
        target: { seat: 0, cards: ['S9', 'H9', 'D9', 'S4', 'D4'], combination: { type: 'triple-pair' } },
        decisionId: 'match-test:30', revision: 30, remaining: [10, 4, 1],
        events: [{ id: 'HISTORY_SENTINEL', speech: 'OLD_SPEECH', emoteUrl: 'https://old.example/image' }],
    };
    const invitation = formatInvite({ observation, toolInstructions: 'DUPLICATE_TOOL_TEXT' });
    assert.match(invitation, /\[系统邀请指令:\]/);
    assert.match(invitation, /## 斗地主 · 当前状态/);
    assert.match(invitation, /你的手牌：梅花4〔`C4`〕/);
    assert.match(invitation, /三带二/);
    assert.match(invitation, /合法压牌或不出/);
    assert.doesNotMatch(invitation, /HISTORY_SENTINEL|OLD_SPEECH|old\.example|DUPLICATE_TOOL_TEXT|omittedEventCount|"hand":/);
    for (const field of ['matchId', 'decisionId', 'revision']) {
        assert.equal(invitation.split(`${field}：`).length - 1, 1);
    }
    assert.equal(observation.events.length, 1);
    assert.match(formatInvite({ observation: { ...observation, target: null, canPass: false } }), /首出，不能不出/);
    const bidInvite = formatInvite({ observation: { ...observation, phase: 'bidding', landlord: null, highestBid: 2 } });
    assert.match(bidInvite, /当前最高叫分：2分/);
    assert.doesNotMatch(bidInvite, /当前有效上家牌|地主：/);
});
test('纯动作没有假台词；表达是公开事件的可选字段', () => {
    const payload = {
        seats: [{ name: '莱恩' }, { name: '小克' }],
        event: { phase: 'playing', id: 'e1', seat: 1, type: 'pass' },
    };
    assert.doesNotMatch(formatPublicEvent(payload), /公开发言|表情URL/);
    payload.event.speech = '不要。';
    payload.event.emoteUrl = 'https://example.com/emote.png';
    assert.match(formatPublicEvent(payload), /公开发言："不要。"/);
    assert.match(formatPublicEvent(payload), /表情URL/);
});