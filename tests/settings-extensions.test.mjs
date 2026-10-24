import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    registerSettingsSection,
    settingsSectionExtensions,
    requestSettingsSection,
    takeRequestedSettingsSection,
    onSettingsExtensionChange,
} from '../modules/settings/extensions.js';

const require = createRequire(import.meta.url);

test('a registered section is listed and announced; duplicates and missing fields throw', () => {
    const seen = [];
    const off = onSettingsExtensionChange(change => seen.push(change));
    registerSettingsSection({ section: { key: 'demo-a' }, label: '演示' });
    assert.deepEqual(settingsSectionExtensions().map(item => [item.key, item.label, item.icon]), [['demo-a', '演示', 'circle']]);
    assert.equal(seen[0].type, 'section');
    assert.equal(seen[0].extension.key, 'demo-a');
    assert.throws(() => registerSettingsSection({ section: { key: 'demo-a' }, label: '又一个' }), /重名/);
    assert.throws(() => registerSettingsSection({ section: {}, label: 'x' }), TypeError);
    off();
    registerSettingsSection({ section: { key: 'demo-b' }, label: 'B', icon: 'star' });
    assert.equal(seen.length, 1);
});

test('a section request is announced and taken once', () => {
    const seen = [];
    const off = onSettingsExtensionChange(change => seen.push(change));
    requestSettingsSection('demo-a');
    assert.deepEqual(seen, [{ type: 'request', key: 'demo-a' }]);
    assert.equal(takeRequestedSettingsSection(), 'demo-a');
    assert.equal(takeRequestedSettingsSection(), null);
    requestSettingsSection('');
    assert.equal(seen.length, 1);
    off();
});

test('the preload registry picks up a feature module preloadApi.js under its directory name', () => {
    const { loadRegistry } = require('../preloads/core/registry.js');
    const registry = loadRegistry();
    const entry = registry.get('toggleDeskPet');
    assert.ok(entry, 'toggleDeskPet comes from modules/deskpet/preloadApi.js');
    assert.equal(entry.domain, 'deskpet');
    assert.equal(entry.where, 'modules/deskpet/preloadApi.js');
});
