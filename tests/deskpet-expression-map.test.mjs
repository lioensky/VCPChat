import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as map from '../DeskPetmodules/expressionMap.js';

const require = createRequire(import.meta.url);
const profiles = require('../modules/deskpet/expressionProfile.js');

const NAMES = ['F_Normal', 'F_Smile', 'F_Cry', 'Blush', 'Angry2'];
const GROUPS = ['Idle', 'Tap', 'Wave', 'FlickDown'];

test('main process and pet page agree on the twelve emotions', () => {
    assert.deepEqual(profiles.EMOTION_KEYS, map.EMOTION_KEYS);
});

test('auto mapping: sample models by file name, others by expression name', () => {
    assert.equal(map.modelNameOf('vcp-deskpet://pet/agent/A/deskpet/x/Natori.model3.json'), 'natori');
    assert.equal(map.autoExpression('happy', ['Normal', 'Smile'], 'natori'), 'Smile');
    assert.equal(map.autoExpression('happy', NAMES), 'F_Smile');
    assert.equal(map.autoExpression('sad', NAMES), 'F_Cry');
    assert.equal(map.autoExpression('curious', NAMES), null);
    assert.equal(map.autoMotion('happy', GROUPS), 'Tap');
    assert.equal(map.autoMotion('neutral', GROUPS), null);
});

test('deskpet.json wins when the model has that name; an empty motion means no motion', () => {
    const profile = { expressions: { happy: 'Blush', sad: 'Missing' }, motions: { happy: 'Wave', sad: '' } };
    assert.equal(map.pickExpression('happy', NAMES, profile), 'Blush');
    assert.equal(map.pickExpression('sad', NAMES, profile), 'F_Cry', 'unknown names fall back to auto');
    assert.equal(map.pickMotion('happy', GROUPS, profile), 'Wave');
    assert.equal(map.pickMotion('sad', GROUPS, profile), null);
    assert.equal(map.pickMotion('angry', GROUPS, profile), null);
    const rows = map.describeMapping({ names: NAMES, groups: GROUPS, profile });
    const happy = rows.find((r) => r.emotion === 'happy');
    assert.deepEqual([happy.label, happy.expression, happy.expressionSet, happy.autoExpression, happy.motion, happy.motionSet], ['开心', 'Blush', true, 'F_Smile', 'Wave', true]);
    const sad = rows.find((r) => r.emotion === 'sad');
    assert.equal(sad.expressionSet, false);
    assert.equal(sad.motionSet, true);
    assert.equal(rows.length, 12);
});

test('saving keeps unrelated keys, drops auto entries and names the model does not have', () => {
    const existing = { motions: { yawn: 'Sleepy', happy: 'Tap' }, expressions: { angry: 'Angry2' }, note: 'mine' };
    const next = profiles.mergeProfile(existing, {
        expressions: { happy: 'F_Smile', sad: 'Nope', angry: null },
        motions: { happy: '', shy: 'Wave', sad: 'Nope' },
    }, { names: NAMES, groups: GROUPS });
    assert.deepEqual(next, { motions: { yawn: 'Sleepy', happy: '', shy: 'Wave' }, expressions: { happy: 'F_Smile' }, note: 'mine' });
    assert.deepEqual(profiles.mergeProfile({ expressions: { happy: 'F_Smile' } }, {}, { names: NAMES, groups: GROUPS }), {});
});

test('reads expression names and motion groups from model3.json and writes deskpet.json beside it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-map-'));
    const model = path.join(dir, 'm.model3.json');
    fs.writeFileSync(model, JSON.stringify({
        FileReferences: {
            Moc: 'm.moc3',
            Expressions: [{ Name: 'F_Smile', File: 'a.exp3.json' }, { Name: 'F_Smile', File: 'b.exp3.json' }, { File: 'nameless.exp3.json' }],
            Motions: { Idle: [], Tap: [] },
        },
    }));
    assert.deepEqual(await profiles.readModelCatalog(model), { names: ['F_Smile'], groups: ['Idle', 'Tap'] });
    assert.deepEqual(await profiles.readProfile(model), {});
    await profiles.writeProfile(model, { expressions: { happy: 'F_Smile' } });
    assert.deepEqual(await profiles.readProfile(model), { expressions: { happy: 'F_Smile' } });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['deskpet.json', 'm.model3.json']);
});

test('main process and pet page agree on the tap zones', () => {
    assert.deepEqual(profiles.TAP_KEYS, map.TAP_KEYS);
});

test('tap bindings: only names the model has count, an unbound zone keeps the default reaction', () => {
    const profile = { taps: { head: { expression: 'Blush', motion: 'Missing' }, body: { expression: 'Nope' } } };
    assert.deepEqual(map.pickTap('head', NAMES, GROUPS, profile), { expression: 'Blush', motion: null });
    assert.equal(map.pickTap('body', NAMES, GROUPS, profile), null);
    assert.equal(map.pickTap('head', NAMES, GROUPS, {}), null);
    assert.equal(map.pickTap('head', NAMES, GROUPS, { taps: { head: 'Blush' } }), null);
    assert.deepEqual(map.describeTaps({ names: NAMES, groups: GROUPS, profile: { taps: { body: { motion: 'Wave' } } } }), [
        { zone: 'head', label: '点头', expression: null, motion: null },
        { zone: 'body', label: '点身体', expression: null, motion: 'Wave' },
    ]);
});

test('saving tap bindings keeps valid names per zone and drops empty zones', () => {
    const catalog = { names: NAMES, groups: GROUPS };
    const next = profiles.mergeProfile({ taps: { head: { motion: 'Tap' } }, idle: 'Idle' }, {
        taps: { head: { expression: 'Blush', motion: 'Missing' }, body: { expression: null, motion: 'Wave' } },
    }, catalog);
    assert.deepEqual(next, { idle: 'Idle', taps: { head: { expression: 'Blush' }, body: { motion: 'Wave' } } });
    assert.deepEqual(profiles.mergeProfile({ taps: { head: { motion: 'Tap' } } }, { taps: { head: { expression: null, motion: null } } }, catalog), {});
    assert.deepEqual(profiles.mergeProfile({ taps: { head: { motion: 'Tap' } } }, {}, catalog), {});
});
