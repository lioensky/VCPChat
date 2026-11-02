import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseEmotionTagBody, createEmotionTagScanner, stripEmotionTags } from '../modules/emotion/emotionTags.js';
import { resolveControlTokens, createModelControlLayer } from '../DeskPetmodules/modelControls.js';
const require = createRequire(import.meta.url);
const { assignControlNames, capabilityPrompt } = require('../modules/deskpet/live2dCapabilities.js');

test('readable names preserve spaces, disambiguate reserved names and numeric endings', () => {
    const items = assignControlNames([
        { id: 'e1', name: '左手 半边比心', kind: 'expression', parameters: [{ id: 'hand', value: 1 }] },
        { id: 'm2', name: '左手 半边比心', kind: 'motion' },
        { id: 'e3', name: 'nod', kind: 'expression' },
        { id: 'e4', name: '动作 2', kind: 'expression' },
        { id: 'e5', name: 'A+B/ C', kind: 'expression' },
    ]);
    assert.deepEqual(items.map(i => i.controlName), ['左手 半边比心', '左手 半边比心（2）', 'nod（2）', '动作（2）', 'A B C']);
    for (const item of items) {
        const tag = parseEmotionTagBody(`emo:happy/${item.controlName}`);
        assert.equal(tag.variant, item.controlName.toLowerCase());
        assert.equal(tag.intensity, 0.7);
        assert.deepEqual(resolveControlTokens(tag.variant, items), [item.id]);
    }
    assert.deepEqual(resolveControlTokens('左手 半边比心（2）', items), ['m2']);
    assert.deepEqual(resolveControlTokens(' e1 + 左手 半边比心 + unknown ', items), ['e1']);
    assert.deepEqual(resolveControlTokens('same', [{ id: 'e1', name: 'same' }, { id: 'e2', name: 'same' }]), []);
    const prompt = capabilityPrompt({ items });
    assert.match(prompt, /<!--emo:happy\/左手 半边比心 0.8-->/);
    for (const item of items) assert.ok(!prompt.includes(item.id));
    const values = {};
    const core = { _model: { parameters: { ids: ['hand'], defaultValues: [0] } },
        setParameterValueById: (id, value) => { values[id] = value; } };
    const layer = createModelControlLayer(core, id => id, items);
    assert.equal(layer.play(resolveControlTokens('左手 半边比心', items), 0.8), true);
    layer.apply(0.1);
    assert.equal(values.hand, 0.8);
    const backend = readFileSync(new URL('../DeskPetmodules/live2dBackend.js', import.meta.url), 'utf8');
    assert.match(backend, /resolveControlTokens\(variant, catalog\?\.items\)/);
});

test('Chinese and English multiword names parse with optional trailing numeric intensity', () => {
    for (const name of ['左手 半边比心', 'Left hand', 'Left half heart', '星星眼']) {
        for (const [suffix, strength] of [['', 0.7], [' 0.8', 0.8], [' .4', 0.4], [' 9', 1], [' -2', 0]]) {
            assert.deepEqual(parseEmotionTagBody(`emo:happy/${name}${suffix}`),
                { emotion: 'happy', variant: name.toLowerCase(), intensity: strength });
        }
    }
    assert.equal(parseEmotionTagBody('emo:happy/左手 半边比心\n正文'), null);
});

test('every stream split preserves exactly one tag and all visible text', () => {
    for (const name of ['左手 半边比心', 'Left hand']) {
        const source = `前文<!--emo:happy/${name} 0.8-->后文`;
        for (let split = 0; split <= source.length; split++) {
            const scanner = createEmotionTagScanner();
            const events = [...scanner.push(source.slice(0, split)), ...scanner.push(source.slice(split)), ...scanner.finish()];
            assert.deepEqual(events.filter(e => e.type === 'tag').map(e => e.variant), [name.toLowerCase()]);
            assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), '前文后文');
            assert.ok(!stripEmotionTags(source.slice(0, split), { streaming: true }).includes('emo:'));
        }
        assert.equal(stripEmotionTags(source), '前文后文');
        const scanner = createEmotionTagScanner();
        const events = [...source].flatMap(c => scanner.push(c)).concat(scanner.finish());
        assert.equal(events.filter(e => e.type === 'tag').length, 1);
    }
    // 缺失闭合符时不猜测带空格名字的结束位置，更不能吞掉正文。
    assert.match(stripEmotionTags('<!--emo:happy/左手 半边比心 正文\n第二行'), /正文\n第二行/);
});