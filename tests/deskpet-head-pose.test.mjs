import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadPoseLimiter } from '../DeskPetmodules/headPoseLimits.js';

const limits = { x: 8, y: 5, z: 4 };
function model(values = [45, -30, 30, 1, 0.7, 12]) {
    const parameters = {
        ids: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamMouthOpenY', 'ParamBodyAngleX'],
        values: [...values], minimumValues: [-45, -30, -30, -1, 0, -30],
        maximumValues: [45, 30, 30, 1, 1, 30], defaultValues: [0, 0, 0, 0, 0, 0],
    };
    const core = { _model: { parameters }, setParameterValueById(id, value) { parameters.values[parameters.ids.indexOf(id)] = value; } };
    return { parameters, apply: createHeadPoseLimiter(core, (id) => id) };
}

test('large combined poses shrink to gentle head turns while eyes, mouth and body retain their values', () => {
    const { parameters, apply } = model();
    apply(limits);
    assert.deepEqual(parameters.values, [8, -5, 4, 1, 0.7, 12]);
});

test('motion stays continuous around the neutral face, including negative and intermediate values', () => {
    const { parameters, apply } = model([22.5, 15, -15, 0, 0, 0]);
    apply(limits);
    assert.deepEqual(parameters.values.slice(0, 3), [4, 2.5, -2]);
    parameters.values.splice(0, 3, 0, 0, 0);
    apply(limits);
    assert.deepEqual(parameters.values.slice(0, 3), [0, 0, 0]);
});

test('the final guard prevents late overrides and does not scale an already limited pose twice', () => {
    const { parameters, apply } = model();
    apply(limits); apply(limits, false);
    assert.deepEqual(parameters.values.slice(0, 3), [8, -5, 4]);
    parameters.values.splice(0, 3, -100, 100, -100);
    apply(limits, false);
    assert.deepEqual(parameters.values.slice(0, 3), [-8, 5, -4]);
});

test('models without limits keep their motions and malformed options cannot produce NaN', () => {
    const { parameters, apply } = model();
    const before = [...parameters.values];
    apply(undefined); apply({ x: -1, y: '5', z: NaN });
    assert.deepEqual(parameters.values, before);
    assert.doesNotThrow(() => createHeadPoseLimiter({}, (id) => id)(limits));
    apply({ x: 0 });
    assert.equal(parameters.values[0], 0);
});

test('asymmetric parameter ranges stay centered on their authored neutral pose', () => {
    const { parameters, apply } = model([12, 0, 0, 0, 0, 0]);
    parameters.defaultValues[0] = 2; parameters.minimumValues[0] = -18; parameters.maximumValues[0] = 42;
    apply(limits);
    assert.equal(parameters.values[0], 4);
});
