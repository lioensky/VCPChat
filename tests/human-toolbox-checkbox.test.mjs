import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../VCPHumanToolBox/renderer.js', import.meta.url), 'utf8');

function extract(start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1);
    const to = source.indexOf(end, from);
    assert.notEqual(to, -1);
    return source.slice(from, to);
}

const collect = new Function('toolForm', 'FormData', 'toolName',
    extract('        const formData = new FormData(toolForm);', '        const requiresExplicitScope')
    + 'return args;');

for (const rerank of [true, false]) {
    for (const jev of [true, false]) {
        test(`A/B sends explicit booleans: rerank=${rerank}, jev=${jev}`, () => {
            const controls = [
                { name: 'compare_rerank', type: 'checkbox', checked: rerank, dataset: {} },
                { name: 'compare_jev', type: 'checkbox', checked: jev, dataset: {} }
            ];
            const form = {
                querySelectorAll(selector) {
                    return selector.includes(':not(') ? controls : [];
                },
                querySelector(selector) {
                    return controls.find(control => selector.includes(`"${control.name}"`));
                }
            };
            class FakeFormData {
                *entries() {
                    yield ['command', 'memory_ab'];
                    for (const control of controls) {
                        if (control.checked) yield [control.name, 'on'];
                    }
                }
            }
            assert.deepEqual(collect(form, FakeFormData, 'LightMemo'), {
                command: 'memory_ab', compare_rerank: rerank, compare_jev: jev
            });
        });
    }
}

test('disabled checkboxes are omitted and grouped checkboxes retain array semantics', () => {
    const form = {
        querySelectorAll(selector) {
            if (selector.includes(':not(')) {
                return [{ name: 'inactive', checked: true, disabled: true }];
            }
            return [{ dataset: { checkboxGroup: 'choices' }, value: 'one' }];
        },
        querySelector() { return { dataset: { checkboxGroup: 'choices' } }; }
    };
    class FakeFormData {
        *entries() { yield ['choices__one', 'one']; }
    }
    assert.deepEqual(collect(form, FakeFormData, 'Example'), { choices: ['one'] });
});

test('checkbox defaults do not treat string false as true and create no shadow hidden field', () => {
    const document = {
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(), children: [], style: {},
                appendChild(child) { this.children.push(child); }
            };
        }
    };
    const create = new Function('document', 'toolForm',
        extract('    function createParamElement(', '    function createTranslationContainer(')
        + 'return createParamElement;')(document, {});
    for (const value of [true, false, 'true', 'false', undefined]) {
        const group = create({ name: 'compare_jev', type: 'checkbox', default: value }, [], 'LightMemo');
        const controls = [];
        function walk(element) {
            if (element.tagName === 'INPUT') controls.push(element);
            for (const child of element.children) walk(child);
        }
        walk(group);
        assert.equal(controls.length, 1);
        assert.equal(controls[0].type, 'checkbox');
        assert.equal(controls[0].checked, value === true || value === 'true');
        assert.equal(controls[0].defaultChecked, controls[0].checked);
    }
});

test('cached A/B command rebuilds parameter controls before restoring checkbox state', () => {
    const state = { command: 'memory_ab', compare_jev: false, compare_rerank: true };
    let controls = [];
    const command = {
        name: 'command', value: 'query',
        dispatchEvent() {
            controls = ['compare_jev', 'compare_rerank'].map(name => ({
                name, type: 'checkbox', checked: true, closest() { return null; }
            }));
        },
        closest() { return null; }
    };
    const form = {
        querySelector() { return command; },
        querySelectorAll(selector) {
            if (selector.includes(':checked')) return [];
            return [command, ...controls];
        }
    };
    const restore = new Function('toolForm', 'formStateCache', 'Event',
        extract('    function restoreFormState(', '    function buildToolForm(')
        + 'return restoreFormState;')(form, new Map([['LightMemo', state]]), class Event {});
    restore('LightMemo');
    assert.equal(command.value, 'memory_ab');
    assert.deepEqual(controls.map(control => control.checked), [false, true]);
});