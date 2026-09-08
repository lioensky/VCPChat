import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = relativePath => fs.readFileSync(new URL(relativePath, root), 'utf8');

test('GroupRenderer delegates settings and list DOM to group slots', () => {
    const renderer = read('Groupmodules/grouprenderer.js');
    assert.doesNotMatch(renderer, /\b(?:innerHTML|outerHTML|createElement|insertAdjacentHTML)\b/);
    assert.doesNotMatch(renderer, /GroupSettingsMarkup|groupSettingsMarkup/);
});

test('main loads the system group slots and removes the legacy markup bridge', () => {
    const main = read('main.html');
    assert.match(main, /modules\/ui-system\/settings\/group-slots\.js/);
    assert.doesNotMatch(main, /Groupmodules\/groupSettingsMarkup\.js/);
    assert.equal(fs.existsSync(new URL('../Groupmodules/groupSettingsMarkup.js', import.meta.url)), false);
});
