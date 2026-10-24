/* Local rule fallback for replies that carry no emotion tag: phrase rules with degree words,
 * negation and "but" weighting, reduced to the shared 12 emotion keys.
 * Adapted from TsukuMate's chat-emotion-classifier.js (Roxy's own project), retargeted from the
 * user's message to the assistant's reply and extended with excited / affectionate / curious /
 * concerned. Conservative on purpose: a weak signal returns null so the portrait stays put. */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 每条规则一个短语组和它在各情绪上的分数；重叠的匹配只保留最长的那个
const VECTOR_RULES = [
    { pattern: /没有生[气氣]|不生[气氣]|并不讨厌|並不討厭|不讨厌|不討厭|不难过|不難過|不累|别担心|別擔心|不用担心|不用擔心|not\s+(?:angry|mad|sad|tired)|(?:do not|don't)\s+(?:hate|worry)/gi, scores: {} },
    { pattern: /不开心|不開心|不高兴|不高興|not\s+happy/gi, scores: { sad: 6 } },
    { pattern: /害羞|不好意思|脸红|臉紅|羞涩|羞澀|人家才|才不是|照れ|恥ずかし|\bshy\b|\bembarrass(?:ed|ing)?\b|\bblush(?:ed|ing)?\b/gi, scores: { shy: 6 } },
    { pattern: /喜欢你|喜歡你|爱你|愛你|想你|抱抱|亲亲|親親|摸摸头|摸摸頭|贴贴|貼貼|陪着你|陪著你|一直在你身边|最喜欢|最喜歡|\blove\s+you\b|\bmiss\s+you\b|\bhugs?\b/gi, scores: { affectionate: 6, shy: 1 } },
    { pattern: /好耶|太棒了|太好了吧|激动|激動|兴奋|興奮|迫不及待|超级期待|超級期待|冲呀|衝呀|\byay\b|\bwoo+hoo\b|so\s+excited|can't\s+wait/gi, scores: { excited: 6, happy: 2 } },
    { pattern: /惊讶|驚訝|吓一跳|嚇一跳|惊呆|驚呆|真的假的|天哪|天啊|竟然|居然|欸[？?!！]|诶[？?!！]|びっくり|\bsurpris(?:e|ed|ing)\b|\bshock(?:ed|ing)?\b|\bwhoa\b|no\s+way/gi, scores: { surprised: 6 } },
    { pattern: /惊喜|驚喜|没想到|沒想到|\bwow\b/gi, scores: { surprised: 4, happy: 3 } },
    { pattern: /好奇|有意思|有趣|让我看看|讓我看看|我想知道|是什么呢|是什麼呢|为什么呢|為什麼呢|咦|嗯\?|嗯？|\bcurious\b|\binteresting\b|\bhmm+\b|i\s+wonder/gi, scores: { curious: 5 } },
    { pattern: /担心|擔心|小心|注意安全|别勉强|別勉強|没事吧|沒事吧|还好吗|還好嗎|要紧吗|要緊嗎|抱歉|对不起|對不起|不安|紧张|緊張|\bworr(?:y|ied)\b|\bsorry\b|\bcareful\b|are\s+you\s+(?:ok|okay|alright)/gi, scores: { concerned: 5 } },
    { pattern: /气死|氣死|生气|生氣|愤怒|憤怒|不爽|可恶|可惡|过分|過分|讨厌|討厭|哼[！!]|闭嘴|閉嘴|笨蛋|むかつ|怒り|\bannoy(?:ed|ing)\b|\bangry\b|\bmad\b|how\s+dare/gi, scores: { angry: 6 } },
    { pattern: /难过|難過|伤心|傷心|委屈|失望|遗憾|遺憾|孤独|孤獨|痛苦|心疼|哭了|呜呜|嗚嗚|悲し|寂し|\bsad\b|\bupset\b|disappoint|\blonely\b|unfortunately/gi, scores: { sad: 6 } },
    { pattern: /好困|想睡|犯困|晚安|睡觉|睡覺|累死|好累|疲惫|疲憊|打哈欠|哈欠|眠い|\bsleepy\b|\btired\b|exhausted|\byawn/gi, scores: { tired: 6 } },
    { pattern: /平静|平靜|安心|放松|放鬆|慢慢来|慢慢來|不着急|不著急|没关系|沒關係|\brelax\b|take\s+your\s+time|no\s+rush/gi, scores: { calm: 4 } },
    { pattern: /开心|開心|高兴|高興|太好了|成功了|完成了|修好了|搞定|幸福|嘿嘿|哈哈|嘻嘻|うれし|嬉し|楽しい|\bhappy\b|\bglad\b|awesome|great\s+news|\bhaha\b/gi, scores: { happy: 5 } },
    { pattern: /谢谢|謝謝|感谢|感謝|辛苦了|不客气|不客氣|棒|厉害|厲害|完美|\bthank(?:s|\s+you)?\b|\bgreat\b|\bperfect\b|amazing|\bnice\b/gi, scores: { happy: 3 } },
];

const TIE_PRIORITY = ['shy', 'affectionate', 'surprised', 'angry', 'sad', 'concerned', 'excited', 'tired', 'curious', 'happy', 'calm'];

function collectMatches(text) {
    const matches = [];
    VECTOR_RULES.forEach((rule, ruleIndex) => {
        rule.pattern.lastIndex = 0;
        for (const match of text.matchAll(rule.pattern)) {
            if (!match[0]) continue;
            matches.push({ start: match.index, end: match.index + match[0].length, scores: rule.scores, ruleIndex });
        }
    });
    matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.ruleIndex - b.ruleIndex);
    const accepted = [];
    for (const candidate of matches) {
        if (accepted.some(item => candidate.start < item.end && candidate.end > item.start)) continue;
        accepted.push(candidate);
    }
    return accepted;
}

function contextMultiplier(text, match) {
    const before = text.slice(Math.max(0, match.start - 24), match.start);
    let multiplier = 1;
    if (/(?:非常|极其|極其|特别|特別|超级|超級|真的太|really|very|so\s+so)\s*$/i.test(before)) multiplier *= 2;
    else if (/(?:很|太|真|好|so)\s*$/i.test(before)) multiplier *= 1.5;
    else if (/(?:有点|有點|有些|稍微|a\s+little|a\s+bit)\s*$/i.test(before)) multiplier *= 0.5;
    if (/(?:没有|沒有|并不|並不|不是|不太|没|沒|不|别|別|not|never|don't|do\s+not)\s*$/i.test(before)) multiplier *= 0.2;
    return multiplier;
}

// "但是"之后的情绪是落点，权重更高
function clauseMultiplier(text, index) {
    const markers = [...text.matchAll(/但是|但|不过|不過|可是|然而|\bbut\b|\byet\b|でも|しかし/gi)];
    if (!markers.length) return 1;
    return index < markers[markers.length - 1].index ? 0.8 : 1.25;
}

const EMOJI_SIGNALS = [
    { pattern: /[😊😄😁☺🙂]/u, emotion: 'happy', score: 4 },
    { pattern: /[🎉🥳🤩✨]/u, emotion: 'excited', score: 4 },
    { pattern: /[🥰😘❤💕💖]/u, emotion: 'affectionate', score: 4 },
    { pattern: /[😢😭💔🥺]/u, emotion: 'sad', score: 5 },
    { pattern: /[😡🤬💢]/u, emotion: 'angry', score: 6 },
    { pattern: /[😳🙈]/u, emotion: 'shy', score: 5 },
    { pattern: /[😮😲😯]/u, emotion: 'surprised', score: 5 },
    { pattern: /[😴🥱💤]/u, emotion: 'tired', score: 5 },
    { pattern: /[🤔🧐]/u, emotion: 'curious', score: 4 },
    { pattern: /[😟😥😰]/u, emotion: 'concerned', score: 4 },
];

/** 给一段回复正文打分；返回 { emotion, intensity, score } 或 null（信号太弱时） */
export function classifyReplyText(input, { minScore = 3 } = {}) {
    const text = String(input ?? '').slice(-2000);
    if (!text.trim()) return null;
    const scores = Object.fromEntries(TIE_PRIORITY.map(emotion => [emotion, 0]));
    for (const match of collectMatches(text)) {
        const multiplier = contextMultiplier(text, match) * clauseMultiplier(text, match.start);
        for (const [emotion, value] of Object.entries(match.scores)) scores[emotion] += value * multiplier;
    }
    let intensityBonus = 0;
    for (const signal of EMOJI_SIGNALS) {
        if (!signal.pattern.test(text)) continue;
        scores[signal.emotion] += signal.score;
        intensityBonus += 0.08;
    }
    if (/[!！]{2,}/.test(text)) {
        intensityBonus += 0.1;
        // 开心的话带上一串感叹号就是兴奋
        if (scores.happy > 0 && scores.happy >= scores.excited) scores.excited += scores.happy * 0.6 + 1;
    }
    const ordered = TIE_PRIORITY
        .map((emotion, priority) => ({ emotion, score: scores[emotion], priority }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.priority - b.priority);
    const best = ordered[0];
    if (!best || best.score < minScore) return null;
    return { emotion: best.emotion, intensity: clamp(best.score / 8 + intensityBonus, 0.3, 1), score: best.score };
}
