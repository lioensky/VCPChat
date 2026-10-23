import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { section } from '../modules/settings/schema/kernel.js';
import { registerSettingsSection } from '../modules/settings/extensions.js';
import { applySchemaSurface } from '../modules/settings/schema-surface.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.document = dom.window.document;
global.window = dom.window;
global.HTMLElement = dom.window.HTMLElement;
const doc = dom.window.document;

test('a registered section gets its own host; a core section without one in the page is left alone', () => {
    registerSettingsSection({ section: section('demo-extension', '演示', []), label: '演示' });
    const form = doc.createElement('form');
    assert.deepEqual(applySchemaSurface(form, doc), ['demo-extension']);
    const host = form.querySelector('#section-demo-extension');
    assert.ok(host, 'extension host appended');
    assert.equal(host.dataset.settingsSectionKey, 'demo-extension');
    assert.equal(form.querySelector('#section-quick-actions'), null, 'core hosts come from main.html only');
    assert.deepEqual(applySchemaSurface(form, doc), []);
    assert.equal(form.querySelectorAll('#section-demo-extension').length, 1);
});
