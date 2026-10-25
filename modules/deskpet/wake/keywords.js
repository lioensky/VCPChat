'use strict';

// 中文按词组转换；拼音支持声调符号、数字声调和连写。
// 无声调时按“不同音节”展开声调，同一音节重复时保持相同读音，最多 64 个候选。
const { pinyin } = require('pinyin-pro');
const TONES = ['aāáǎà', 'eēéěè', 'iīíǐì', 'oōóǒò', 'uūúǔù', 'üǖǘǚǜ'];
const INITIALS = /^(zh|ch|sh|b|p|m|f|d|t|n|l|g|k|h|j|q|x|r|z|c|s|y|w)/;

function plain(value) {
    return value.normalize('NFD').replace(/[\u0300-\u0304\u030c]/g, '').replace(/u\u0308/g, 'ü').normalize('NFC');
}

function numbered(value) {
    const match = /^(.*?)([0-5])$/.exec(value);
    if (!match) return value;
    let word = match[1].replace(/v|u:/g, 'ü');
    const tone = Number(match[2]);
    if (!tone || tone === 5) return word;
    let index = word.indexOf('a');
    if (index < 0) index = word.indexOf('e');
    if (index < 0 && word.includes('ou')) index = word.indexOf('o');
    if (index < 0) {
        for (let i = word.length - 1; i >= 0; i--) {
            if ('iouü'.includes(word[i])) { index = i; break; }
        }
    }
    const row = TONES.find(item => item[0] === word[index]);
    return row ? word.slice(0, index) + row[tone] + word.slice(index + 1) : word;
}

function buildSyllables(tokens) {
    const syllables = new Map();
    const initials = ['', 'zh', 'ch', 'sh', ...'bpmfdtnlgkhjqxrzcs yw'.replace(/ /g, '')];
    for (const final of tokens) {
        if (!/[aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(final)) continue;
        if (/^[A-Z<#]/.test(final)) continue;
        for (const initial of initials) {
            if (initial && !tokens.has(initial)) continue;
            const word = initial + final;
            const key = plain(word);
            if (!syllables.has(key)) syllables.set(key, []);
            syllables.get(key).push({ word, units: initial ? [initial, final] : [final] });
        }
    }
    return syllables;
}

function splitJoined(word, syllables) {
    if (word.length % 2 === 0 && word.slice(0, word.length / 2) === word.slice(word.length / 2)) {
        const half = splitJoined(word.slice(0, word.length / 2), syllables);
        if (half) return [...half, ...half];
    }
    const memo = new Map();
    function visit(offset) {
        if (offset === word.length) return [];
        if (memo.has(offset)) return memo.get(offset);
        // 最长合法音节优先；有歧义时建议在设置中用空格分隔。
        for (let end = Math.min(word.length, offset + 6); end > offset; end--) {
            const part = word.slice(offset, end);
            if (!syllables.has(part)) continue;
            const rest = visit(end);
            if (rest) { const result = [part, ...rest]; memo.set(offset, result); return result; }
        }
        memo.set(offset, null);
        return null;
    }
    return visit(0);
}

function compilePhrase(raw, tokens, syllables) {
    let words;
    if (/[\u3400-\u9fff]/.test(raw)) {
        if (!/^[\u3400-\u9fff\s]+$/.test(raw)) throw new Error('中文与拼音请分别作为别名填写');
        words = pinyin(raw.replace(/\s/g, ''), { type: 'array', toneType: 'symbol' });
    } else {
        const input = raw.toLowerCase().replace(/u:/g, 'ü').replace(/v/g, 'ü');
        if (!/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ0-5\s']+$/.test(input)) throw new Error('唤醒词仅支持中文或中文拼音');
        words = [];
        for (const part of input.split(/[\s']+/).filter(Boolean)) {
            if (/[0-5]/.test(part)) {
                const pieces = part.match(/[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+[0-5]/g);
                if (!pieces || pieces.join('') !== part) throw new Error('数字拼音请写成 nuo4 wa2 或 nuo4wa2');
                words.push(...pieces.map(numbered));
            } else if (part !== plain(part)) {
                words.push(part);
            } else {
                const parts = splitJoined(part, syllables);
                if (!parts) throw new Error(`不能解析拼音「${part}」，请用空格和数字声调修正`);
                words.push(...parts);
            }
        }
    }
    if (words.length < 2 || words.length > 12) throw new Error('唤醒词需要 2～12 个音节，建议 4 个音节');
    const choices = new Map();
    for (const word of words) {
        if (choices.has(word)) continue;
        const exact = word !== plain(word);
        const candidates = (syllables.get(plain(word)) || []).filter(item => !exact || item.word === word);
        if (!candidates.length) throw new Error(`模型不支持读音「${word}」`);
        choices.set(word, candidates);
    }
    let combinations = [new Map()];
    for (const [word, candidates] of choices) {
        if (combinations.length * candidates.length > 64) throw new Error('无声调拼音候选过多，请补充数字声调，例如 nuo4 wa2 nuo4 wa2');
        combinations = combinations.flatMap(combo => candidates.map(candidate => new Map([...combo, [word, candidate]])));
    }
    return {
        pronunciation: words.join(' '),
        variants: combinations.map(combo => words.flatMap(word => combo.get(word).units).join(' ')),
    };
}

function compileKeywords(agents, tokenText) {
    const tokens = new Set(tokenText.split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/)[0]));
    const syllables = buildSyllables(tokens);
    const owners = new Map();
    const lines = [];
    const previews = {};
    for (const [agentId, config] of Object.entries(agents)) {
        if (!config.enabled) continue;
        const aliases = [...new Set(String(config.phrases || '').split(/[|\n]/).map(s => s.trim()).filter(Boolean))];
        if (!aliases.length || aliases.length > 8) throw new Error('每个助手请填写 1～8 个唤醒别名');
        previews[agentId] = [];
        for (const alias of aliases) {
            const compiled = compilePhrase(alias, tokens, syllables);
            previews[agentId].push({ alias, pronunciation: compiled.pronunciation, candidates: compiled.variants.length });
            for (const variant of compiled.variants) {
                const owner = owners.get(variant);
                if (owner && owner !== agentId) throw new Error('不同助手的唤醒词存在相同读音，请修改');
                if (owner) continue;
                owners.set(variant, agentId);
                const label = `wake_${Object.keys(previews).indexOf(agentId)}`;
                lines.push(`${variant} :1.5 #0.35 @${label}`);
            }
        }
    }
    const routes = Object.fromEntries(Object.keys(previews).map((id, index) => [`wake_${index}`, id]));
    if (lines.length > 256) throw new Error('唤醒候选总数超过 256，请减少别名或补充声调');
    return { text: lines.join('\n'), routes, previews };
}

module.exports = { compileKeywords, numbered, plain };