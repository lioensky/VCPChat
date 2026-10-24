import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseEmotionTagBody, createEmotionTagScanner, stripEmotionTags } from '../modules/emotion/emotionTags.js';
import { controlTokens, dueModelControls, createModelControlLayer } from '../DeskPetmodules/modelControls.js';

const require = createRequire(import.meta.url);
const { readCapabilities, capabilityPrompt } = require('../modules/deskpet/live2dCapabilities');
const { createPetStream } = require('../modules/deskpet/petStream');

test('combined controls tolerate missing, invalid and out-of-range intensity', () => {
    for (const [raw, expected] of [['', 0.7], [' bad', 0.7], [' 9', 1], [' -2', 0], [' .4', 0.4]]) {
        const parsed = parseEmotionTagBody(`emo:happy/e123+m456+nod${raw}`);
        assert.equal(parsed.intensity, expected);
        assert.equal(parsed.variant, 'e123+m456+nod');
    }
    assert.deepEqual(controlTokens('E123+nod,e123'), ['e123', 'nod']);
    const source = '<!--emo:happy/e123+m456 bad-->你好';
    const scanner = createEmotionTagScanner();
    const events = [...source].flatMap(char => scanner.push(char)).concat(scanner.finish());
    assert.equal(events.filter(e => e.type === 'tag').length, 1);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), '你好');
    assert.equal(stripEmotionTags(source), '你好');
    assert.equal(stripEmotionTags('`<!--emo:happy/e123-->`'), '`<!--emo:happy/e123-->`');
});

test('controls reveal once and collapse bursts to the last tag', () => {
    const tags = [{ at: 1, variant: 'e1' }, { at: 5, variant: 'nod+m2', intensity: 0.8 }];
    assert.deepEqual(dueModelControls(tags, 1), []);
    assert.deepEqual(dueModelControls(tags, 6), [{ variant: 'nod+m2', intensity: 0.8 }]);
    assert.deepEqual(dueModelControls(tags, null), []);
});

test('temporary layer defaults strength, does not accumulate, rejects unknown ids and restores', () => {
    const values = {};
    const core = { _model: { parameters: { ids: ['eye'], defaultValues: [0] } }, setParameterValueById: (id, value) => { values[id] = value; } };
    const layer = createModelControlLayer(core, id => id, [{ id: 'e1', kind: 'expression', parameters: [{ id: 'eye', value: 1, blend: 'Overwrite' }] }]);
    assert.equal(layer.play(['unknown'], 1), false);
    assert.equal(layer.play(['e1'], 'bad'), true);
    layer.apply(0.1);
    assert.equal(values.eye, 0.7);
    layer.apply(0.1);
    assert.equal(values.eye, 0.7);
    for (let i = 0; i < 45; i++) layer.apply(0.1);
    assert.equal(layer.active, false);
    assert.equal(values.eye, 0);
});

test('discovers VTS and undeclared files, excludes wardrobe/system animations, uses stable scoped ids', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-capabilities-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const write = (name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value));
    const exp = { Parameters: [{ Id: 'eye', Value: 1, Blend: 'Overwrite' }] };
    const animation = { Meta: { Duration: 1 }, Curves: [] };
    await write('m.model3.json', { Version: 3, FileReferences: {} });
    await write('m.vtube.json', { Name: '不要注入身份', FileReferences: { IdleAnimation: '待机.motion3.json' }, Hotkeys: [
        { Action: 'ToggleExpression', Name: '按键 星星眼', File: '按键 星星眼.exp3.json' },
        { Action: 'TriggerAnimation', Name: '比心', File: '比心.motion3.json' },
        { Action: 'ToggleExpression', Name: '逃逸', File: '../outside.exp3.json' },
    ] });
    await write('按键 星星眼.exp3.json', exp);
    await write('按键 脸红.exp3.json', exp);
    await write('衣服 女仆.exp3.json', exp);
    await write('比心.motion3.json', animation);
    await write('待机.motion3.json', animation);
    const model = path.join(dir, 'm.model3.json');
    const catalog = await readCapabilities(model);
    assert.deepEqual(catalog.items.map(i => i.name).sort(), ['星星眼', '比心', '脸红'].sort());
    assert.deepEqual(await readCapabilities(model), catalog);
    const prompt = capabilityPrompt(catalog);
    assert.doesNotMatch(prompt, /不要注入身份|女仆|待机|\.json|当前形象/);
    assert.match(prompt, /星星眼/);
    await write('m2.model3.json', { Version: 3, FileReferences: {} });
    const other = await readCapabilities(path.join(dir, 'm2.model3.json'));
    assert.ok(!other.items.some(item => catalog.items.some(old => old.id === item.id)));
    assert.deepEqual(JSON.parse(await fs.readFile(model, 'utf8')), { Version: 3, FileReferences: {} });

    const pet = { ready: true, backendKind: 'live2d', outfit: 'one', capabilitiesOutfit: 'one', capabilities: catalog };
    const stream = createPetStream({ pets: new Map([['a', pet]]), emotionPrompt: {
        shouldAddEmotionTagPrompt: () => false,
    } });
    assert.match(stream.getSystemPromptAppend('a'), /星星眼/);
    assert.equal(stream.getSystemPromptAppend('b'), '');
    pet.outfit = 'two';
    assert.doesNotMatch(stream.getSystemPromptAppend('a'), /星星眼/);
    pet.outfit = 'one';
    pet.backendKind = null;
    assert.doesNotMatch(stream.getSystemPromptAppend('a'), /星星眼/);
});

test('combined expression channels, blend modes and replacement restore without parameter creation', () => {
    const values = {};
    const core = { _model: { parameters: { ids: ['eye', 'hand'], defaultValues: [1, 0] } },
        setParameterValueById: (id, value) => { values[id] = value; } };
    const layer = createModelControlLayer(core, id => id, [
        { id: 'e1', kind: 'expression', parameters: [{ id: 'eye', value: 2, blend: 'Multiply' }] },
        { id: 'e2', kind: 'expression', parameters: [{ id: 'hand', value: 1, blend: 'Add' }, { id: 'missing', value: 1 }] },
    ]);
    layer.play(['e1', 'e2'], 1);
    layer.apply(0.1);
    assert.deepEqual(values, { eye: 2, hand: 1 });
    layer.play(['e2'], 1);
    layer.apply(0.1);
    assert.deepEqual(values, { eye: 1, hand: 1 });
    layer.play(['e2'], -9);
    layer.apply(0.1);
    assert.deepEqual(values, { eye: 1, hand: 0 });
});

test('oversized controls and tags in protected regions never execute', () => {
    assert.equal(controlTokens(Array.from({ length: 50 }, (_, i) => `e${i}`).join('+')).length, 8);
    for (const [open, close] of [['```', '```'], ['<think>', '</think>'],
        ['<<<[TOOL_REQUEST]>>>', '<<<[END_TOOL_REQUEST]>>>']]) {
        const scanner = createEmotionTagScanner();
        const events = scanner.push(`${open}<!--emo:happy/e1 0.8-->${close}`).concat(scanner.finish());
        assert.equal(events.filter(event => event.type === 'tag').length, 0);
    }
});